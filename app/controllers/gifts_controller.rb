class GiftsController < ApplicationController    
  def update
    gift = Gift.find(params[:id])
    gift.update_attributes(gift_params)
    redirect_to gift.list.url
  end
  
  def create
    gift = Gift.create(gift_params)
    list = List.find(params[:list_id])
    list.gifts.push(gift)
    redirect_to controller: "lists", action: "show", id: params[:list_id]
  end
  
  def delete
    gift = Gift.find(params[:id]).delete()
    redirect_to gift.url 
  end
  
  def edit
    @gift = Gift.find(params[:id])
    @action = "update"
    @list = @gift.list
  end
  
  def move_up
    gift = Gift.find(params[:id])
    gift.move_higher
    redirect_to gift.list.url 
  end
  
  def move_down
    gift = Gift.find(params[:id])
    gift.move_lower
    redirect_to gift.list.url 
  end
  
  private

  def gift_params
    params.require(:gift).permit(:name, :url, :price, :image)
  end
end