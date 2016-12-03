class ListsController < ApplicationController
  def show
    @list = List.find(params[:id])
    @gift = Gift.new
    @action = "create"
  end

  def new
    @list = List.new
    @action = "create"
  end

  def update
    list = List.find(params[:id])
    list.update_attributes(list_params)
    redirect_to list.url
  end

  def edit
    @list = List.find(params[:id])
    @action = "update"
  end

  def create
    list = List.create(list_params)
    @user = current_user || User.create
    list.update_attribute(:user, @user.id)
    session[:redirect_to_list] = list.url
    sign_in_and_redirect @user
  end

  def delete
    List.find(params[:id]).delete
    redirect_to root_path
  end

  private

  def list_params
    params.require(:list).permit(:name)
  end
end
