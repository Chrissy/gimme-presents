class List < ActiveRecord::Base
  has_many :gifts, -> { order("position DESC")}

  def url
    "/#{id}"
  end

  def edit_link
    "/edit/#{id}"
  end
end
